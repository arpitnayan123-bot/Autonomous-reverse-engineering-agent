/**
 * Wire bun-types (already a devDependency) into the Next.js tsc program:
 * the native-tools regression suite runs under `bun test` and needs the
 * `bun:test` module declarations plus the `Bun` global (Bun.serve fixture
 * server). Triple-slash reference — same pattern as the other ambient d.ts
 * files in this directory; does NOT restrict the automatically included
 * @types packages the way a tsconfig "types" array would.
 */
/// <reference types="bun-types" />
