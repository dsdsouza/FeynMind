// Unit tests must never reach the network. Any real fetch fails the test loudly.
// Tests that need fetch inject their own fake rather than using the global.
globalThis.fetch = () => {
  throw new Error('Network access is not allowed in unit tests. Inject a fake fetch instead.')
}
