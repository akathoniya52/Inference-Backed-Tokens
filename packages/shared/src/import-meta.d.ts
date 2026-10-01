// `@ibt/shared` is browser-safe and compiles with `types: []`, so neither
// `@types/node` nor `lib.dom` is present to declare the standard ESM field.
interface ImportMeta {
  readonly url: string;
}
