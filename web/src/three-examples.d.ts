declare module "three/examples/jsm/exporters/GLTFExporter.js" {
  export class GLTFExporter {
    parse(
      input: unknown,
      onDone: (result: ArrayBuffer | object) => void,
      onError: (error: Error) => void,
      options?: Record<string, unknown>
    ): void;
  }
}
