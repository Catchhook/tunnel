import { clearConfig, getConfigPath } from "../lib/config.js";
import * as ui from "../lib/ui.js";

export async function logoutCommand(): Promise<void> {
  clearConfig();
  ui.success("Logged out. Config cleared at " + getConfigPath());
}
