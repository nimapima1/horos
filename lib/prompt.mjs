// Frågar efter ett lösenord i terminalen utan att visa det (inget eko, ingen historik).
export function promptHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let pw = '';
    stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          // Inklistring kan ge markörer (ESC[200~ … ESC[201~) och andra styrtecken.
          return resolve(pw.replace(/\x1b\[20[01]~/g, '').replace(/[\x00-\x1f\x7f]/g, ''));
        }
        if (c === '\u0003') process.exit(130);                       // Ctrl-C
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);       // backsteg
        else pw += c;
      }
    });
  });
}
