// Lägger in Geotorget-inloggningen (för historiska flygfoton) i serverns skyddade
// hemlighetsfil via "fastighetskarta-admin set-secret". Lösenordet efterfrågas dolt och
// skickas direkt över SSH på stdin; det hamnar aldrig i en kommandorad, en fil eller en logg.
//
//   node scripts/login-till-server.mjs deploy@<server-ip> <geotorget-användarnamn>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promptHidden } from '../lib/prompt.mjs';

const [target, user] = process.argv.slice(2);
if (!target || !user) {
  console.error('Användning: node scripts/login-till-server.mjs deploy@<server-ip> <geotorget-användarnamn>');
  process.exit(1);
}
const password = await promptHidden(`Geotorget-lösenord för ${user}: `);
if (!password) { console.error('Tomt lösenord, inget skickat.'); process.exit(1); }

// Windows egen ssh läser SSH-lösenfrasen från konsolen, så stdin kan bära hemligheterna.
const ssh = existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe') ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh';
const admin = 'sudo -n /usr/local/sbin/fastighetskarta-admin';
const child = spawn(ssh, [target,
  `${admin} set-secret GEOTORGET_USER && ${admin} set-secret GEOTORGET_PASS && echo 'Hemligheter på servern:' && ${admin} list-secrets`],
  { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(`${user}\n${password}\n`);   // set-secret läser en rad var
child.on('exit', (code) => process.exit(code ?? 1));
