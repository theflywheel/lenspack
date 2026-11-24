import { loadExample } from "../_shared/load";

export { seed, seedSearch, documents } from "./seed";
export const { packYaml, pack, boards } = loadExample(import.meta.url);
