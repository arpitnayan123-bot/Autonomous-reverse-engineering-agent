/**
 * REA Ghidra postscript — full disassembly dump to <outDir>/out/disasm.txt
 *
 * Registry contract (src/server/retools/registry.ts, tool id "ghidra"):
 *   analyzeHeadless <out> ReaProject -import /rea/input
 *     -scriptPath /rea/scripts -postScript ReaDisasm.java <out> -deleteProject
 *
 * Script arguments: args[0] = output directory (docker mode: /rea).
 * Writes args[0]/out/disasm.txt — one code unit (instruction or defined data)
 * per line: "address  hex-bytes  representation". Output is hard-bounded at
 * MAX_LINES so a pathological binary cannot fill the work dir quota.
 *
 * Deterministic: output depends only on the analyzed binary (no timestamps).
 */
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.CodeUnit;
import ghidra.program.model.listing.CodeUnitIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryAccessException;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

public class ReaDisasm extends GhidraScript {

	/** Hard output bound (lines) — an honest truncation marker is written when hit. */
	private static final long MAX_LINES = 2_000_000;

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length < 1 || args[0].isBlank()) {
			throw new RuntimeException(
				"ReaDisasm: expected the output directory as the first postscript argument " +
				"(registry passes <outPath>); received " + args.length + " argument(s)");
		}

		File outDir = new File(new File(args[0]), "out");
		if (!outDir.isDirectory() && !outDir.mkdirs()) {
			throw new RuntimeException("ReaDisasm: cannot create output directory " + outDir.getAbsolutePath());
		}
		File outFile = new File(outDir, "disasm.txt");

		Program program = currentProgram;
		long lines = 0;
		boolean truncated = false;
		PrintWriter writer = new PrintWriter(new BufferedWriter(
			new OutputStreamWriter(new FileOutputStream(outFile), StandardCharsets.UTF_8)));
		try (writer) {
			writer.println("// disasm.txt — Ghidra disassembly dump of " + program.getName()
					+ " (instructions and defined data)");
			CodeUnitIterator units = program.getListing().getCodeUnits(true);
			while (units.hasNext()) {
				if (lines >= MAX_LINES) {
					truncated = true;
					break;
				}
				CodeUnit unit = units.next();
				Address address = unit.getAddress();
				String bytes = "";
				if (unit instanceof Instruction) {
					try {
						bytes = toHex(((Instruction) unit).getBytes());
					}
					catch (MemoryAccessException e) {
						bytes = "";
					}
				}
				if (bytes.isEmpty()) {
					writer.println(address.toString() + "  " + unit.toString());
				}
				else {
					writer.println(address.toString() + "  " + bytes + "  " + unit.toString());
				}
				lines++;
			}
			if (truncated) {
				writer.println("// … truncated at MAX_LINES=" + MAX_LINES + " (binary larger than the dump bound)");
			}
		}
		// PrintWriter swallows IOExceptions — surface a failed write honestly.
		if (writer.checkError()) {
			throw new RuntimeException("ReaDisasm: I/O error while writing " + outFile.getAbsolutePath());
		}

		println("ReaDisasm: wrote " + outFile.getAbsolutePath() + " (" + lines + " lines"
				+ (truncated ? ", TRUNCATED" : "") + ")");
	}

	private static String toHex(byte[] bytes) {
		StringBuilder sb = new StringBuilder(bytes.length * 3);
		for (byte b : bytes) {
			if (sb.length() > 0) {
				sb.append(' ');
			}
			sb.append(String.format("%02x", b));
		}
		return sb.toString();
	}
}
