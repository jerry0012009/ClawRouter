export function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port)) throw new Error("port must be an integer");
  return port;
}
