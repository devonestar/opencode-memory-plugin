import { homedir } from "node:os"
import { join } from "node:path"

export function resolveOpenCodeConfigRoot(): string {
  const xdgConfigHome = process.env["XDG_CONFIG_HOME"]
  const configHome = xdgConfigHome !== undefined && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config")
  return join(configHome, "opencode")
}
