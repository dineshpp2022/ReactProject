// Predefined list of Odoo instances with their database names
export const ODOO_CONFIG = [
  {
    url: 'https://squadsm.odoo.com',
    dbName: 'squadsm',
    label: 'Squad SM'
  },
  {
    url: 'https://squadts.odoo.com',
    dbName: 'squadts',
    label: 'Squad TS'
  },
  {
    url: 'https://squad-atlas.odoo.com',
    dbName: 'squad-atlas',
    label: 'Squad Atlas'
  },
  {
    url: 'https://ascensivetechnologies.com',
    dbName: 'asccomm',
    label: 'Ascensive Technologies'
  }
];

export const findOdooConfig = (url) => {
  if (!url) return null;
  const normalizedUrl = url.trim().toLowerCase();
  return ODOO_CONFIG.find(config => config.url.toLowerCase() === normalizedUrl);
};

export const getAllOdooUrls = () => ODOO_CONFIG.map(config => config.url);
