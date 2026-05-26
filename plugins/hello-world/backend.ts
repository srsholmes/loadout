import { detectDevice } from "@loadout/device";
import type { PluginBackend, PluginLogger } from "@loadout/types";

export default class HelloWorld implements PluginBackend {
  log?: PluginLogger;

  async ping(): Promise<string> {
    const device = await detectDevice();
    this.log?.info(`ping from ${device.id}`);
    return `pong from ${device.id}`;
  }

  async getDevice() {
    const device = await detectDevice();
    return {
      id: device.id,
      gamescope: device.gamescope,
      capabilities: { ...device.capabilities },
    };
  }
}
