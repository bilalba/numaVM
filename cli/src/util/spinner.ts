import ora from "ora";

export function spin(text: string) {
  return ora({ text, color: "cyan" }).start();
}
