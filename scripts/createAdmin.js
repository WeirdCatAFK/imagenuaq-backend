#!/usr/bin/env node
// Creates an admin, or restores one that can no longer log in.
// Usage: npm run admin:create -- --email a@uaq.mx --name "Nombre Apellido"
//                               [--contract <id|name>] [--area <id|name>]
// Password: read from the ADMIN_PASSWORD environment variable, or prompted for when this
// runs on a terminal. Never pass it as an argument -- argv is readable through `ps` on a
// shared host and lands in shell history.
// Area: --area, or without it the area DEFAULT_AREA names in .env, or none when that is
// unset or matches nothing. A named --area that matches nothing is refused; the default
// falling through to "none" is not, by decision -- see Areas.defaultArea().
//
// Why this is a script and not an endpoint.
//
// Accounts are created by coordination through POST /api/users, which requires an admin
// session. That is a closed loop, and it jams in two ways: nobody has been created yet, or
// every admin has lost their credentials or left. The second case is why this cannot be an
// HTTP route gated on "no admins exist" -- in a lockout the admin rows are still there,
// perfectly valid and simply unusable, so such a route would refuse to help in exactly the
// situation it was built for.
//
// The gate is therefore not a claim made over the network but possession of DATABASE_URL.
// Whoever can reach the database can already do all of this with psql; this only makes it
// correct -- the same bcrypt cost as the running server, and no chance of writing a hash
// the API cannot verify. It grants nothing that database access did not already carry, and
// it is unreachable from outside the host.
//
// Run against an address that already exists, it PROMOTES that user to admin and resets
// their password. That is the lockout path, and it is deliberately something the API
// cannot do: raising somebody to coordination is the one operation whose only safe gate is
// access to the server itself.

import { openStore, closeStore } from '../src/access/primitives/database.js';
import query from '../src/access/resources/query.js';
import auth from '../src/access/orchestration/auth.js';
import areas from '../src/access/orchestration/areas.js';

const ADMIN_ROLE = 'admin';

// Control characters as read in raw mode, written as escapes rather than as the literal
// bytes: an invisible U+0003 in a source file survives no copy, paste or editor round trip
// that normalises control characters, and its disappearance is silent.
const ETX = '\u0003'; // Ctrl-C
const BACKSPACE = '\u007f'; // DEL, which is what most terminals send for Backspace

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// Prompt with the echo suppressed. readline has no password mode, so the terminal goes
// into raw mode and keystrokes are read by hand; otherwise the password stays on screen
// and in the scrollback of whoever ran the recovery.
function promptHidden(questionText) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error('No terminal to prompt on. Set ADMIN_PASSWORD in the environment.'),
      );
      return;
    }

    process.stdout.write(questionText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let value = '';

    const finish = (fn, argument) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      fn(argument);
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r') return finish(resolve, value);

        // Raw mode stops the terminal turning Ctrl-C into SIGINT, so without this branch
        // the prompt cannot be interrupted at all.
        if (char === ETX) return finish(() => process.exit(130));

        if (char === BACKSPACE || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
      return undefined;
    };

    process.stdin.on('data', onData);
  });
}

const email = (arg('email') || '').trim().toLowerCase();
const fullName = (arg('name') || '').trim();

if (!email || !fullName) {
  fail(
    'Usage: npm run admin:create -- --email a@uaq.mx --name "Nombre Apellido"\n' +
      '         [--contract <id|name>] [--area <id|name>]',
  );
}

openStore();

try {
  const role = await query.getRoleIdByName(ADMIN_ROLE);
  if (role === null) {
    fail(
      `No '${ADMIN_ROLE}' role exists. Run \`npm run migrate:up\` first -- the role\n` +
        '  catalog is seeded by the catalog-bootstrap migration.',
    );
  }

  const before = await query.countLiveUsersWithRole(ADMIN_ROLE);

  // Read the password before touching anything, so a mistyped or empty one costs nothing.
  const password =
    process.env.ADMIN_PASSWORD ?? (await promptHidden('  New admin password: '));

  if (!password || password.length < 8) {
    fail('Password must be at least 8 characters long.');
  }

  const existing = await query.getAuthUserByEmail(email);

  if (existing) {
    // The lockout path. setPassword() is not reused because the role has to move in the
    // same statement: a promotion that committed while the password write failed would
    // leave an admin nobody can log in as -- the very state being recovered from.
    const hash = await auth.hashPassword(password);
    await query.promoteToRoleAndSetPassword(existing.id, role, hash);

    const after = await query.countLiveUsersWithRole(ADMIN_ROLE);
    console.log(`\n  ${email} (id ${existing.id}) is now an admin.`);
    console.log(`  Role: ${existing.role_name} -> ${ADMIN_ROLE}. Password reset.`);
    console.log(`  Live admins: ${before} -> ${after}.\n`);
  } else {
    const contractRef = arg('contract');
    const contract = contractRef
      ? await query.findContractType(contractRef)
      : await query.firstContractType();

    if (!contract) {
      fail(
        contractRef
          ? `No contract type matches "${contractRef}".`
          : 'No contract types exist. Run `npm run migrate:up` first.',
      );
    }

    const areaRef = arg('area');
    const area = areaRef ? await query.findArea(areaRef) : await areas.defaultArea();
    if (areaRef && !area) fail(`No area matches "${areaRef}".`);

    const created = await query.createUser({
      email,
      fullName,
      roleId: role,
      contractTypeId: contract.id,
      primaryAreaId: area?.id ?? null,
    });

    await auth.setPassword(created.id, password);

    const after = await query.countLiveUsersWithRole(ADMIN_ROLE);
    const defaulted = contractRef ? '' : ' (default -- first in the catalog)';
    const areaDefaulted = area && !areaRef ? ' (default -- DEFAULT_AREA)' : '';
    console.log(`\n  Admin created: ${email} (id ${created.id}).`);
    console.log(`  Contract type: ${contract.name}${defaulted}.`);
    console.log(`  Area: ${area ? area.name : 'none'}${areaDefaulted}.`);
    console.log(`  Live admins: ${before} -> ${after}.\n`);
  }
} catch (err) {
  // A unique violation here means the address belongs to a SOFT-DELETED user: the live
  // lookup found nothing, but a plain index still holds the row. Say so -- "duplicate key"
  // on an address the operator was just told does not exist is baffling.
  if (err?.code === '23505') {
    fail(`${email} belongs to a deleted user. Restore that row or use another address.`);
  }
  throw err;
} finally {
  await closeStore();
}
