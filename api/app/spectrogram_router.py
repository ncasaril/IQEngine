import json
import logging
import math
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from helpers.datasource_access import check_access
from helpers.samples import get_bytes_per_iq_sample, get_samples
from helpers.spectrogram_engine import compute_spectrogram_db, compute_tile, compute_tile_info
from helpers.urlmapping import ApiType, get_file_name

from . import datasources
from .azure_client import AzureBlobClient
from .models import DataSource

logger = logging.getLogger("api")

router = APIRouter()


async def _get_azure_client(datasource: DataSource) -> AzureBlobClient:
    """Build an AzureBlobClient from a datasource, applying credentials."""
    from helpers.cipher import decrypt

    client = AzureBlobClient(account=datasource.account, container=datasource.container, awsAccessKeyId=datasource.awsAccessKeyId)
    if hasattr(datasource, "sasToken") and datasource.sasToken:
        client.set_sas_token(decrypt(datasource.sasToken.get_secret_value()))
    if hasattr(datasource, "awsSecretAccessKey") and datasource.awsSecretAccessKey:
        client.set_aws_secret_access_key(decrypt(datasource.awsSecretAccessKey.get_secret_value()))
    return client


async def _read_samples_range(client: AzureBlobClient, filepath: str, data_type: str, sample_offset: int, num_samples: int):
    """Read a range of IQ samples from storage."""
    bytes_per_sample = get_bytes_per_iq_sample(data_type)
    byte_offset = sample_offset * bytes_per_sample
    byte_length = num_samples * bytes_per_sample
    content = await client.get_blob_content(filepath=filepath, offset=byte_offset, length=byte_length)
    return get_samples(content, data_type)


@router.get("/api/datasources/{account}/{container}/{filepath:path}/spectrogram/info")
async def get_spectrogram_info(
    filepath: str,
    fft_size: int = Query(1024, description="FFT size (power of 2)"),
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Return tile grid metadata for a recording's spectrogram."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_azure_client(datasource)
    iq_file = get_file_name(filepath, ApiType.IQDATA)

    try:
        file_length = await client.get_file_length(iq_file)
    except Exception:
        raise HTTPException(status_code=404, detail="IQ data file not found")

    # Read the metadata to get the data type
    meta_file = get_file_name(filepath, ApiType.METADATA)
    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
        data_type = meta["global"]["core:datatype"]
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read metadata for data type")

    bytes_per_sample = get_bytes_per_iq_sample(data_type)
    total_samples = file_length // bytes_per_sample

    info = compute_tile_info(total_samples, fft_size)
    info["data_type"] = data_type
    info["file_length_bytes"] = file_length

    # Add sample rate and center freq if available
    try:
        captures = meta.get("captures", [])
        if captures:
            info["center_freq_hz"] = captures[0].get("core:frequency", None)
        info["sample_rate_hz"] = meta["global"].get("core:sample_rate", None)
    except Exception:
        pass

    return info


@router.get("/api/datasources/{account}/{container}/{filepath:path}/spectrogram/tile/{zoom}/{time_index}")
async def get_spectrogram_tile(
    filepath: str,
    zoom: int,
    time_index: int,
    fft_size: int = Query(1024, description="FFT size (power of 2)"),
    window: str = Query("hanning", description="Window function"),
    cmap: str = Query("viridis", description="Colormap name"),
    mag_min: Optional[float] = Query(None, description="Min dB for colormap"),
    mag_max: Optional[float] = Query(None, description="Max dB for colormap"),
    format: str = Query("png", description="Output format: png or float32"),
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Return a single spectrogram tile as PNG (or raw float32)."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_azure_client(datasource)
    iq_file = get_file_name(filepath, ApiType.IQDATA)
    meta_file = get_file_name(filepath, ApiType.METADATA)

    # Read metadata for data type
    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
        data_type = meta["global"]["core:datatype"]
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read metadata for data type")

    bytes_per_sample = get_bytes_per_iq_sample(data_type)

    try:
        file_length = await client.get_file_length(iq_file)
    except Exception:
        raise HTTPException(status_code=404, detail="IQ data file not found")

    total_samples = file_length // bytes_per_sample
    tile_height = 256
    total_ffts = total_samples // fft_size

    if total_ffts == 0:
        raise HTTPException(status_code=400, detail="Recording too small for requested FFT size")

    max_zoom = max(0, math.ceil(math.log2(max(total_ffts / tile_height, 1))))

    if zoom < 0 or zoom > max_zoom:
        raise HTTPException(status_code=400, detail=f"Zoom must be 0-{max_zoom}")

    rows_per_tile_row = 2 ** (max_zoom - zoom)
    start_fft = time_index * tile_height * rows_per_tile_row
    end_fft = min(start_fft + tile_height * rows_per_tile_row, total_ffts)

    if start_fft >= total_ffts:
        raise HTTPException(status_code=404, detail="Tile index out of range")

    # Read just the samples we need for this tile
    sample_start = start_fft * fft_size
    sample_end = end_fft * fft_size
    num_samples = sample_end - sample_start

    samples = await _read_samples_range(client, iq_file, data_type, sample_start, num_samples)

    if format == "float32":
        db_array = compute_spectrogram_db(samples, fft_size, window)
        return Response(content=db_array.tobytes(), media_type="application/octet-stream", headers={"X-Rows": str(db_array.shape[0]), "X-Cols": str(db_array.shape[1])})

    # We already sliced to this tile's sample range. Compute the sub-tile
    # with the correct zoom relative to the sliced data.
    sub_total_ffts = end_fft - start_fft
    sub_max_zoom = max(0, math.ceil(math.log2(max(sub_total_ffts / tile_height, 1))))
    png_bytes, tile_meta = compute_tile(
        samples,
        fft_size=fft_size,
        zoom=0,
        time_index=0,
        tile_height=tile_height,
        window=window,
        cmap=cmap,
        mag_min=mag_min,
        mag_max=mag_max,
        total_ffts=sub_total_ffts,
        max_zoom=sub_max_zoom,
    )

    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={
            "X-Tile-Rows": str(tile_meta["rows"]),
            "X-Tile-Cols": str(tile_meta["cols"]),
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
