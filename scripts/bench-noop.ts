/**
 * Benchmark workload extension: registers /noop so `pi -p "/noop"` exercises
 * the full startup path and exits without triggering an LLM turn. Loaded via
 * `-e` in every print-mode benchmark scenario (see scripts/bench.py) so the
 * workload stays identical between the with/without pi-help variants.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function noopExtension(pi: ExtensionAPI) {
	pi.registerCommand("noop", {
		description: "Benchmark no-op command",
		handler: async () => {},
	});
}
