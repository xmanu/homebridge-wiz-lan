import { Characteristic, Service, Service as WizService } from "homebridge";

import HomebridgeWizLan from "../../wiz";
import { Device } from "../../types";
import {
  getPilot as _getPilot,
  setPilot as _setPilot,
} from "../../util/network";
import {
  clampRgb,
  colorTemperature2rgb,
  kelvinToMired,
  rgb2colorTemperature,
  rgbToHsv,
} from "../../util/color";
import { isRGB, isTW } from "./util";
import {
  transformDimming,
  transformHue,
  transformOnOff,
  transformSaturation,
  transformTemperature,
} from "./characteristics";
import { HAPStatus, HapStatusError } from "hap-nodejs";

export interface Pilot {
  mac: string;
  rssi: number;
  src: string;
  state: boolean;
  sceneId: number;
  temp?: number;
  dimming: number;
  r?: number;
  g?: number;
  b?: number;
}

// We need to cache all the state values
// since we need to send them all when
// updating, otherwise the bulb resets
// to default values
export const cachedPilot: { [mac: string]: Pilot } = {};

export const disabledAdaptiveLightingCallback: {
  [mac: string]: () => void;
} = {};

function updatePilot(
  wiz: HomebridgeWizLan,
  service: Service,
  device: Device,
  pilot: Pilot | Error
) {
  service
    .getCharacteristic(wiz.Characteristic.On)
    .updateValue(pilot instanceof Error ? pilot : transformOnOff(pilot));
  service
    .getCharacteristic(wiz.Characteristic.Brightness)
    .updateValue(pilot instanceof Error ? pilot : transformDimming(pilot));
  if (isTW(device) || isRGB(device)) {
    service
      .getCharacteristic(wiz.Characteristic.ColorTemperature)
      .updateValue(
        pilot instanceof Error ? pilot : transformTemperature(pilot)
      );
  }
  if (isRGB(device)) {
    service
      .getCharacteristic(wiz.Characteristic.Hue)
      .updateValue(pilot instanceof Error ? pilot : transformHue(pilot));
    service
      .getCharacteristic(wiz.Characteristic.Saturation)
      .updateValue(pilot instanceof Error ? pilot : transformSaturation(pilot));
  }
}

// Write a custom getPilot/setPilot that takes this
// caching into account
export function getPilot(
  wiz: HomebridgeWizLan,
  service: Service,
  device: Device,
  onSuccess: (pilot: Pilot) => void,
  onError: (error: Error) => void
) {
  let callbacked = false;
  const onDone = (error: Error | null, pilot: Pilot) => {
    const shouldCallback = !callbacked;
    callbacked = true;
    if (error !== null) {
      if (shouldCallback) {
        onError(error);
      } else {
        service.getCharacteristic(wiz.Characteristic.On).updateValue(error);
      }
      delete cachedPilot[device.mac];
      return;
    }

    const old = cachedPilot[device.mac];
    if (
      typeof old !== "undefined" &&
      (pilot.sceneId !== 0 ||
        pilot.r !== old.r ||
        pilot.g !== old.g ||
        pilot.b !== old.b ||
        pilot.temp !== old.temp)
    ) {
      disabledAdaptiveLightingCallback[device.mac]?.();
    }
    cachedPilot[device.mac] = pilot;
    if (shouldCallback) {
      onSuccess(pilot);
    } else {
      updatePilot(wiz, service, device, pilot);
    }
  };
  const timeout = setTimeout(() => {
    if (device.mac in cachedPilot) {
      onDone(null, cachedPilot[device.mac]);
    } else {
      onDone(new Error("No response within 1s"), undefined as any);
    }
  }, 1000);
  _getPilot<Pilot>(wiz, device, (error, pilot) => {
    clearTimeout(timeout);
    onDone(error, pilot);
  });
}

export function setPilot(
  wiz: HomebridgeWizLan,
  device: Device,
  pilot: Partial<Pilot>,
  callback: (error: Error | null) => void
) {
  const oldPilot = cachedPilot[device.mac];
  if (typeof oldPilot == "undefined") {
    return;
  }
  const oldPilotValues = {
    state: oldPilot.state ?? false,
    dimming: oldPilot.dimming ?? 10,
    temp: oldPilot.temp,
    r: oldPilot.r,
    g: oldPilot.g,
    b: oldPilot.b,
  };
  const newPilot = {
    ...oldPilotValues,
    ...pilot,
  };
  cachedPilot[device.mac] = { ...oldPilot, ...newPilot };
  return _setPilot(wiz, device, newPilot, (error) => {
    if (error !== null) {
      cachedPilot[device.mac] = oldPilot;
    }
    callback(error);
  });
}

export function pilotToColor(pilot: Pilot) {
  if (typeof pilot.temp === "number") {
    return {
      ...rgbToHsv(colorTemperature2rgb(Number(pilot.temp))),
      temp: Number(pilot.temp),
    };
  }
  const rgb = clampRgb({
    r: Number(pilot.r) || 0,
    g: Number(pilot.g) || 0,
    b: Number(pilot.b) || 0,
  });
  return { ...rgbToHsv(rgb), temp: rgb2colorTemperature(rgb) };
}

// Need to update hue, saturation, and temp when ANY of these change
export function updateColorTemp(
  device: Device,
  service: WizService,
  wiz: HomebridgeWizLan,
  next: (error: Error | null) => void
) {
  return (error: Error | null) => {
    if (isTW(device)) {
      if (error === null) {
        const color = pilotToColor(cachedPilot[device.mac]);
        service
          .getCharacteristic(wiz.Characteristic.ColorTemperature)
          .updateValue(kelvinToMired(color.temp));
        if (isRGB(device)) {
          service
            .getCharacteristic(wiz.Characteristic.Saturation)
            .updateValue(color.saturation);
          service
            .getCharacteristic(wiz.Characteristic.Hue)
            .updateValue(color.hue);
        }
      }
    }
    next(error);
  };
}
