/**
 * The slice of clarinet (0.12, MIT) that `open-generative-ui.ts` drives. clarinet ships no types.
 */
declare module "clarinet" {
  export interface CParser {
    write(chunk: string): CParser;
    resume(): CParser;
    error: Error | null;
    textNode: string | undefined;
    onopenobject: (key: string | undefined) => void;
    onkey: (key: string) => void;
    onvalue: (value: string | boolean | number | null) => void;
    onopenarray: () => void;
    onclosearray: () => void;
    oncloseobject: () => void;
    onerror: (error: Error) => void;
  }
  const clarinet: { parser(options?: Record<string, unknown>): CParser };
  export default clarinet;
}
