import type { StdoutParserFactory, UIAdapterModule } from "../types";
import * as hermesAdapterUi from "hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";

const createHermesStdoutParser = (hermesAdapterUi as {
  createHermesStdoutParser?: StdoutParserFactory;
}).createHermesStdoutParser;

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: hermesAdapterUi.parseHermesStdoutLine,
  ...(createHermesStdoutParser ? { createStdoutParser: createHermesStdoutParser } : {}),
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: hermesAdapterUi.buildHermesConfig,
};
