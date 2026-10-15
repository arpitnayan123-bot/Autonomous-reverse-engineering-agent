/**
 * REA Ghidra postscript — binary metadata to <outDir>/out/info.txt
 *
 * Registry contract (src/server/retools/registry.ts, tool id "ghidra"):
 *   analyzeHeadless <out> ReaProject -import /rea/input
 *     -scriptPath /rea/scripts -postScript ReaInfo.java <out> -deleteProject
 *
 * Script arguments: args[0] = output directory (docker mode: /rea).
 * Writes args[0]/out/info.txt: binary name, language (Sleigh ID), compiler
 * spec, executable format, image base, memory size, function count.
 *
 * Deterministic: output depends only on the analyzed binary (no timestamps).
 */
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Program;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

public class ReaInfo extends GhidraScript {

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 1 || args[0].isBlank()) {
			throw new RuntimeException(
				"ReaInfo: expected the output directory as the first postscript argument " +
				"(registry passes <outPath>); received " + args.length + " argument(s)");
		}

		File outDir = new File(new File(args[0]), "out");
		if (!outDir.isDirectory() && !outDir.mkdirs()) {
			throw new RuntimeException("ReaInfo: cannot create output directory " + outDir.getAbsolutePath());
		}
		File outFile = new File(outDir, "info.txt");

		Program program = currentProgram;
		PrintWriter writer = new PrintWriter(new BufferedWriter(
			new OutputStreamWriter(new FileOutputStream(outFile), StandardCharsets.UTF_8)));
		try (writer) {
			writer.println("# info.txt — Ghidra binary info for " + program.getName());
			writer.println("binary-name: " + program.getName());
			writer.println("executable-path: " + program.getExecutablePath());
			writer.println("language: " + program.getLanguage().getLanguageID().getIdAsString());
			writer.println("compiler-spec: " + program.getCompilerSpec().getCompilerSpecID().toString());
			writer.println("executable-format: " + program.getExecutableFormat());
			writer.println("image-base: " + program.getImageBase());
			writer.println("memory-bytes: " + program.getMemory().getNumAddresses());
			writer.println("function-count: " + program.getFunctionManager().getFunctionCount());
		}
		// PrintWriter swallows IOExceptions — surface a failed write honestly.
		if (writer.checkError()) {
			throw new RuntimeException("ReaInfo: I/O error while writing " + outFile.getAbsolutePath());
		}

		println("ReaInfo: wrote " + outFile.getAbsolutePath());
	}
}
