'use strict';
// node-cpu-bound.js — preloaded (NODE_OPTIONS=--require) into every Node process a bounded test run starts.
//
// A BOUND A RUNNER CANNOT SEE IS NO BOUND. lib/bounded-exec.sh bounds test runs by CPU affinity, and a runner that sizes
// its pool from `os.availableParallelism()` honours that. One that sizes it from `os.cpus().length` does not: jest
// 29.3.1 (jest-config/build/getMaxWorkers.js) counts the HOST's CPUs, so AMSD-2974 run 9's reviewer ran 15 workers on
// a 2-core bound — 5.25 GB, memory pressure 98% full. Here `os.cpus()` reports the CPUs this process may run on, the
// same answer availableParallelism already gives. Nothing is runner-specific; an unbounded process is left unchanged.
const os = require('os');

const allowed = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0;
const hostCpus = os.cpus;
if (allowed > 0 && hostCpus().length > allowed) {
  os.cpus = () => hostCpus().slice(0, allowed);
}
