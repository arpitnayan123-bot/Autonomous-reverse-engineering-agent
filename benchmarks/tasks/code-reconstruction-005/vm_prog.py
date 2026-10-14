# vm_prog.py — a captured bytecode program + its interpreter skeleton
# ISA (recovered from the interpreter loop):
#   0x01 PUSH imm8   -> reg = imm8
#   0x02 XOR  imm8   -> reg ^= imm8
#   0x03 ADD  imm8   -> reg = (reg + imm8) & 0xFF
#   0x04 EMIT        -> output.append(chr(reg))
#   0x00 HALT
PROGRAM = bytes([1, 28, 2, 95, 3, 3, 4, 1, 22, 2, 95, 3, 3, 4, 1, 97, 2, 95, 3, 3, 4, 1, 27, 2, 95, 3, 3, 4, 1, 39, 2, 95, 3, 3, 4, 1, 44, 2, 95, 3, 3, 4, 1, 53, 2, 95, 3, 3, 4, 1, 3, 2, 95, 3, 3, 4, 1, 48, 2, 95, 3, 3, 4, 1, 61, 2, 95, 3, 3, 4, 1, 63, 2, 95, 3, 3, 4, 1, 51, 2, 95, 3, 3, 4, 1, 52, 2, 95, 3, 3, 4, 1, 3, 2, 95, 3, 3, 4, 1, 51, 2, 95, 3, 3, 4, 1, 55, 2, 95, 3, 3, 4, 1, 37, 2, 95, 3, 3, 4, 0])

def run(program):
    reg, out, pc = 0, [], 0
    while pc < len(program):
        op = program[pc]; pc += 1
        if op == 0x00:
            break
        if op == 0x01:
            reg = program[pc]; pc += 1
        elif op == 0x02:
            reg ^= program[pc]; pc += 1
        elif op == 0x03:
            reg = (reg + program[pc]) & 0xFF; pc += 1
        elif op == 0x04:
            out.append(chr(reg & 0xFF))
        else:
            raise ValueError(f"bad opcode {op:#x}")
    return "".join(out)

if __name__ == "__main__":
    print(run(PROGRAM))
