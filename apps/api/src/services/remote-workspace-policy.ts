import {
  envSwitch,
  getDeploymentSetting,
  type DeploymentSwitch,
  type SwitchPolicy,
} from "./deployment-settings.js";

export const REMOTE_WORKSPACES_SWITCH: DeploymentSwitch = {
  key: "remoteWorkspaces.enabled",
  env: "OPTIO_REMOTE_WORKSPACES",
};

/** A protective opt-in: a database error must never restore an enabled env default. */
export async function remoteWorkspacesPolicy(): Promise<SwitchPolicy> {
  const environment = envSwitch(REMOTE_WORKSPACES_SWITCH);
  const stored = await getDeploymentSetting(REMOTE_WORKSPACES_SWITCH.key);
  return typeof stored === "boolean"
    ? { value: stored, source: "app", environment }
    : { value: environment, source: "environment", environment };
}

export async function remoteWorkspacesEnabled(): Promise<boolean> {
  try {
    return (await remoteWorkspacesPolicy()).value;
  } catch {
    return false;
  }
}
