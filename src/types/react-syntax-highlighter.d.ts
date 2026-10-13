/**
 * Minimal ambient declarations for the deep `react-syntax-highlighter` esm
 * imports (the package ships no type definitions for these subpaths).
 */
declare module "react-syntax-highlighter" {
  import type { ComponentType, ReactNode } from "react";

  export interface SyntaxHighlighterProps {
    language?: string;
    style?: unknown;
    children?: string | ReactNode;
    codeTagProps?: Record<string, unknown>;
    customStyle?: Record<string, unknown>;
    useInlineStyles?: boolean;
    showLineNumbers?: boolean;
    wrapLongLines?: boolean;
    PreTag?: string | ComponentType<Record<string, unknown>>;
    CodeTag?: string | ComponentType<Record<string, unknown>>;
  }

  export const PrismLight: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, grammar: unknown) => void;
    register: (grammar: unknown, name: string) => void;
  };
  export const Prism: ComponentType<SyntaxHighlighterProps>;
  export const Light: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, grammar: unknown) => void;
  };
  export default Prism;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/*" {
  const style: Record<string, Record<string, unknown>>;
  export default style;
}

declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  const grammar: unknown;
  export default grammar;
}
