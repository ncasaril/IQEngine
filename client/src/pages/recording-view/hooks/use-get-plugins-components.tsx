import { PluginDefinition, PluginParameters } from '@/api/Models';
import React, { useState, SetStateAction, Dispatch, useEffect } from 'react';
import { useGetPlugin, useGetPluginParameters } from '@/api/plugin/queries';

interface PluginOptionProps {
  plugin: PluginDefinition;
  groupIndex: number;
}

export function PluginOption({ plugin, groupIndex }: PluginOptionProps) {
  const { data } = useGetPlugin(plugin);
  return (
    <optgroup key={plugin.name + groupIndex} label={plugin.name}>
      {data?.map((parameter, optionIndex) => {
        return (
          <option key={parameter + optionIndex} value={`${plugin.url}/${parameter}`}>
            {parameter}
          </option>
        );
      })}
    </optgroup>
  );
}

interface PluginParametersProps {
  pluginUrl: string;
  handleSubmit: (e: any) => void;
  setPluginParameters: Dispatch<SetStateAction<PluginParameters>>;
  pluginParameters: PluginParameters;
}

export function EditPluginParameters({ pluginUrl, setPluginParameters, pluginParameters }: PluginParametersProps) {
  const { data: parameters } = useGetPluginParameters(pluginUrl);
  useEffect(() => {
    console.log('parameters', parameters);
    if (parameters) {
      for (const key in parameters) {
        parameters[key] = {
          title: key,
          type: parameters[key].type,
          default: parameters[key].default,
          value: parameters[key].default,
        };
      }
      setPluginParameters(parameters);
    }
  }, [parameters, setPluginParameters]);

  return (
    <>
      {pluginParameters && Object.keys(pluginParameters).length > 0 && (
        <>
          <div className="mb-3">
            {Object.keys(pluginParameters).map((key, index) => {
              const setValue = (v: any) =>
                setPluginParameters((prev) => ({
                  ...prev,
                  [key]: { ...prev[key], value: v },
                }));
              if (key === 'gain') {
                const numeric = parseFloat(pluginParameters[key].value) || 0;
                return (
                  <div key={index + 100000}>
                    <label className="label pb-0">
                      {pluginParameters[key].title}: {numeric.toFixed(2)}×
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={4}
                      step={0.05}
                      name={key}
                      value={numeric}
                      onChange={(e) => setValue(parseFloat(e.target.value))}
                      className="range range-xs range-primary w-full"
                    />
                  </div>
                );
              }
              return (
                <div key={index + 100000}>
                  <label className="label pb-0">{pluginParameters[key].title}</label>
                  <input
                    type={pluginParameters[key].type}
                    name={key}
                    value={pluginParameters[key].value}
                    onChange={(e) => setValue(e.target.value)}
                    className="h-8 w-full box-border rounded text-base-100 px-2"
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export function useGetPluginsComponents() {
  const [pluginParameters, setPluginParameters] = useState<PluginParameters>(null);
  return {
    PluginOption,
    EditPluginParameters,
    pluginParameters,
    setPluginParameters,
  };
}
