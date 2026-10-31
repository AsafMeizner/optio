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

/**
 * Why organization work on a trigger or schedule (a Job, a scheduled Task)
 * can't run in a remote workspace. Pairing mints a full-scope token for a
 * person, and organization work has no owner: its runs fire with nobody
 * present, and whoever last edited the definition (any workspace admin) need
 * not be who created it, so minting the creator's token would hand it to a
 * workspace someone else chose.
 */
export const ORGANIZATION_REMOTE_WORKSPACE_REFUSED =
  "Organization work on a trigger or schedule can't run in a remote workspace: it would pair with a person's token while nobody is present. Make it personal work, or run it on a pod or a machine";
