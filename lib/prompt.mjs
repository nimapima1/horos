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
          stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(pw);
        }
        if (c === '\u0003') process.exit(130);                       // Ctrl-C
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1);       // backsteg
        else pw += c;
      }
    });
  });
}
