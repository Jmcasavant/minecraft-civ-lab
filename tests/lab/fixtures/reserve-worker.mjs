// A separate OS process for real contention tests: each claims from the same SQLite file at the same moment.
import { Ledger } from '../../../lab/broker/ledger.js';
import { CoordinationService } from '../../../lab/coordination/service.js';

const [kind, file, name, startAt, ...rest] = process.argv.slice(2);
const results = [];
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
if (kind === 'ledger') {
    const ledger = new Ledger(file);
    for (let i = 0; i < Number(rest[0]); i++)
        results.push(
            ledger.reserve({
                reservationId: `${name}-${i}`,
                runId: 'race',
                actorId: name,
                model: 'fake',
                maxMicros: Number(rest[1]),
            }).ok,
        );
    ledger.close();
} else if (kind === 'claim') {
    const service = new CoordinationService({ file, runId: 'race', roster: rest });
    results.push(service.forActor(name).taskClaim({ taskId: 'contested', expectedRevision: 1 }).ok);
    service.close();
} else if (kind === 'reserve') {
    const service = new CoordinationService({ file, runId: 'race', roster: rest });
    for (let i = 0; i < 5; i++)
        results.push(
            service.forActor(name).resourceReserve({ container: 'chest', item: 'bread', quantity: 3, stockRevision: 1 })
                .ok,
        );
    service.close();
}
process.stdout.write(JSON.stringify(results));
