import { runCollection } from "./collector.js";

try {
  const state = await runCollection();
  console.log(JSON.stringify({
    generatedAt: state.generatedAt,
    summary: state.summary
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
