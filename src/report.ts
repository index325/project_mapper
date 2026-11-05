import type { MapResult } from "./pipeline.js";

/** Short on purpose: this text goes into the context of the model running in opencode. */
export function formatResult(result: MapResult): string {
  if (result.status === "up_to_date") {
    return `UP TO DATE. ${result.mapPath} already reflects the current code (${result.files} files). No model calls were made.`;
  }
  const skipped = Object.entries(result.skipped)
    .map(([reason, count]) => `${count} ${reason.replace("_", " ")}`)
    .join(", ");
  const lines = [
    `DONE. Map written to ${result.mapPath}.`,
    result.instructionsPath
      ? `Summary updated in ${result.instructionsPath}.`
      : "Instructions file not updated.",
    `Files: ${result.files} (~${result.estimatedTokens} estimated tokens) in ${result.chunks} parts.`,
    `Model calls: ${result.modelCalls}. Reused from cache: ${result.reusedAnswers}. Secrets redacted: ${result.redactions}.`,
  ];
  if (skipped) lines.push(`Skipped files: ${skipped}.`);
  if (result.truncatedFiles.length > 0) {
    lines.push(`Analyzed only in part: ${result.truncatedFiles.join(", ")}.`);
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}
