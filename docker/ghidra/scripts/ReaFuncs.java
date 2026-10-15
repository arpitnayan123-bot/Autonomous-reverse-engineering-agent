/**
 * REA Ghidra postscript — function inventory to <outDir>/out/functions.txt
 *
 * Registry contract (src/server/retools/registry.ts, tool id "ghidra"):
 *   analyzeHeadless <out> ReaProject -import /rea/input
 *     -scriptPath /rea/scripts -postScript ReaFuncs.java <out> -deleteProject
 *
 * Script arguments: args[0] = output directory (docker mode: /rea).
 * Writes args[0]/out/functions.txt — one TAB-separated line per function:
 *   name <TAB> entry-address <TAB> size-in-bytes <TAB> kind
 * (kind: function | external | thunk).
 *
 * Deterministic: output depends only on the analyzed binary (no timestamps).
 */
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Program;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

public class ReaFuncs extends GhidraScript {

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 1 || args[0].isBlank()) {
			throw new RuntimeException(
				"ReaFuncs: expected the output directory as the first postscript argument " +
				"(registry passes <outPath>); received " + args.length + " argument(s)");
		}

		File outDir = new File(new File(args[0]), "out");
		if (!outDir.isDirectory() && !outDir.mkdirs()) {
			throw new RuntimeException("ReaFuncs: cannot create output directory " + outDir.getAbsolutePath());
		}
		File outFile = new File(outDir, "functions.txt");

		Program program = currentProgram;
		int count = 0;
		PrintWriter writer = new PrintWriter(new BufferedWriter(
			new OutputStreamWriter(new FileOutputStream(outFile), StandardCharsets.UTF_8)));
		try (writer) {
			writer.println("# functions.txt — Ghidra function inventory of " + program.getName());
			writer.println("# name\tentry\tsize-bytes\tkind");
			FunctionIterator functions = program.getFunctionManager().getFunctions(true);
			while (functions.hasNext()) {
				Function function = functions.next();
				long size = function.getBody().getNumAddresses();
				String kind = function.isExternal() ? "external" : (function.isThunk() ? "thunk" : "function");
				writer.println(function.getName() + "\t" + function.getEntryPoint() + "\t" + size + "\t" + kind);
				count++;
			}
		}
		// PrintWriter swallows IOExceptions — surface a failed write honestly.
		if (writer.checkError()) {
			throw new RuntimeException("ReaFuncs: I/O error while writing " + outFile.getAbsolutePath());
		}

		println("ReaFuncs: wrote " + outFile.getAbsolutePath() + " (" + count + " functions)");
	}
}
