import fs from 'node:fs';
process.stdout.write(fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/).join(String.fromCharCode(92) + 'n'));
