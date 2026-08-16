process.stdout.write('dsh web: http://127.0.0.1:43125\n')
setImmediate(() => process.disconnect())
