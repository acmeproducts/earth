import { registerHooks } from "node:module";
import { resolve } from "./ts-extension-resolver.mjs";

registerHooks({ resolve });
