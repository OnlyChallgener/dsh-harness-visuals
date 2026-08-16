const { pathToFileURL } = require('node:url')
const [, , binPath, ...args] = process.argv
const LOCAL_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+/u

let startupOutput = ''
let readySent = false
const originalStdoutWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...writeArgs) => {
  startupOutput = `${startupOutput}${String(chunk)}`.slice(-2048)
  const url = startupOutput.match(LOCAL_URL_PATTERN)?.[0]
  if (!readySent && url !== undefined && process.connected) {
    readySent = true
    process.send?.({ type: 'ready', url })
  }
  return originalStdoutWrite(chunk, ...writeArgs)
}

let shuttingDown = false
process.on('message', message => {
  if (message?.type !== 'shutdown' || shuttingDown) return
  shuttingDown = true
  // Windows does not reliably deliver POSIX signals to a child process. The
  // launcher is in the same Node process as dsh, so emitting the signal here
  // lets the CLI's existing bounded shutdown controller run normally.
  process.emit('SIGTERM')
})

process.argv = [process.argv[0], binPath, ...args]
void import(pathToFileURL(binPath).href)
