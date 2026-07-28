if (process.env.SANDBOX_ALLOWED !== "1") {
  console.error("SANDBOX_ALLOWED=1 is required for this disposable environment task");
  process.exit(13);
}
console.log("sandbox environment accepted");
