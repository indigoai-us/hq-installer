declare module "*.hbs" {
  const render: (context: Record<string, unknown>) => string;
  export default render;
}
