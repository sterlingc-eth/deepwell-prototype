/** Adapter registry. Adapters load lazily, so a provider whose flag is off is never imported. */
import { assertAdapter } from "../contract.js";

const LOADERS = {
  gdrive: async () => (await import("./gdrive.js")).createGdriveAdapter(),
  dropbox: async () => (await import("./dropbox.js")).createDropboxAdapter(),
  onedrive: async () => (await import("./onedrive.js")).createOnedriveAdapter(),
};
export async function loadAdapter(id) {
  if (!Object.hasOwn(LOADERS, id)) return null;
  return assertAdapter(await LOADERS[id]());
}
export const FOLDER_PROVIDERS = Object.freeze(Object.keys(LOADERS));
