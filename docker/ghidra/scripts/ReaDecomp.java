/**
 * REA Ghidra postscript — decompile every function to <outDir>/out/decompiled.c
 *
 * Registry contract (src/server/retools/registry.ts, tool id "ghidra"):
 *   analyzeHeadless <out> ReaProject -import /rea/input
 *     -scriptPath /rea/scripts -postScript ReaDecomp.java <out> -deleteProject
 *
 * Script arguments: args[0] = output directory (docker mode: /rea).
 * Writes args[0]/out/decompiled.c — the runner collects "out/decompiled.c"
 * from the work dir as the artifact. Per-function failures are marked inline
 * as comments (evidence-first: observed failures are never silently dropped).
 *
 * Deterministic: output depends only on the analyzed binary (no timestamps).
 */
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Program;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

public class ReaDecomp extends GhidraScript {

	/** Per-function decompiler timeout (seconds) — bounds pathological functions. */
	private static final int PER_FUNCTION_TIMEOUT_SECONDS = 120;

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 1 || args[0].isBlank()) {
			throw new RuntimeException(
				"ReaDecomp: expected the output directory as the first postscript argument " +
				"(registry passes <outPath>); received " + args.length + " argument(s)");
		}

		File outRoot = new File(args[0]);
		File outDir = new File(outRoot, "out");
		if (!outDir.isDirectory() && !outDir.mkdirs()) {
			throw new RuntimeException("ReaDecomp: cannot create output directory " + outDir.getAbsolutePath());
		}
		File outFile = new File(outDir, "decompiled.c");

		Program program = currentProgram;
		DecompInterface decompiler = new DecompInterface();
		decompiler.setOptions(new DecompileOptions());
		if (!decompiler.openProgram(program)) {
			throw new RuntimeException(
				"ReaDecomp: decompiler failed to open program: " + decompiler.getLastMessage());
		}

		int total = 0;
		int decompiled = 0;
		int failed = 0;
		PrintWriter writer = new PrintWriter(new BufferedWriter(
			new OutputStreamWriter(new FileOutputStream(outFile), StandardCharsets.UTF_8)));
		try (writer) {
			writer.println("// decompiled.c — Ghidra headless decompilation of " + program.getName());
			writer.println("// produced by REA postscript ReaDecomp.java; per-function failures are marked inline");
			FunctionIterator functions = program.getFunctionManager().getFunctions(true);
			while (functions.hasNext()) {
				Function function = functions.next();
				total++;
				writer.println();
				writer.println("// ==== " + function.getName() + " @ " + function.getEntryPoint() + " ====");
				DecompileResults result =
					decompiler.decompileFunction(function, PER_FUNCTION_TIMEOUT_SECONDS, monitor);
				if (result != null && result.decompileCompleted()
						&& result.getDecompiledFunction() != null) {
					writer.println(result.getDecompiledFunction().getC());
					decompiled++;
				}
				else {
					String why = (result == null) ? "no result"
							: (result.getErrorMessage() == null ? "decompilation failed"
									: result.getErrorMessage().trim());
					writer.println("// <decompilation failed: " + why + ">");
					failed++;
				}
			}
		}
		finally {
			decompiler.dispose();
		}
		// PrintWriter swallows IOExceptions — surface a failed write honestly.
		if (writer.checkError()) {
			throw new RuntimeException("ReaDecomp: I/O error while writing " + outFile.getAbsolutePath());
		}

		println("ReaDecomp: wrote " + outFile.getAbsolutePath() + " (" + decompiled + "/" + total
				+ " functions decompiled, " + failed + " failed)");
	}
}
