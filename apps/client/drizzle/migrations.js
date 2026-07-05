// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_solid_captain_britain.sql';
import m0001 from './0001_next_stark_industries.sql';
import m0002 from './0002_loving_psynapse.sql';
import m0003 from './0003_classy_vermin.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003
    }
  }
  