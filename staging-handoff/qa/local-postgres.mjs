import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// QA may use a separately provisioned local runtime without changing app dependencies.
const require = createRequire(process.env.ZENTRA_QA_RUNTIME || import.meta.url);
const { default: EmbeddedPostgres } = await import(pathToFileURL(require.resolve('embedded-postgres')));
export const { Client, Pool } = require('pg');
export const { JSDOM } = require('jsdom');
export default EmbeddedPostgres;
