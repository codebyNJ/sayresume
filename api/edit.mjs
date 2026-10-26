import { handle } from "../lib/engine.mjs";
export default { fetch: req => handle("edit", req) };
