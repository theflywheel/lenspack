import { loadExample } from "../_shared/load";

export { seed } from "./seed";
export const { packYaml, pack, boards } = loadExample(import.meta.url);
