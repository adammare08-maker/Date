/* ===========================================================
   Dette — configuration Supabase
   -----------------------------------------------------------
   Ces deux valeurs sont PUBLIQUES par conception : la clé
   "publishable" ne donne aucun droit en elle-même. C'est le
   RLS (Row Level Security), configuré côté base, qui protège
   réellement les données. Ne jamais mettre ici la clé
   "service_role" / secrète.
   =========================================================== */

const DETTE_CONFIG = {
  url: 'https://dzfdlfvjbpvyibslcopj.supabase.co',
  key: 'sb_publishable_z-_aI2zVDC32lMgMNZ65xQ_RmPbQrxi',
};
