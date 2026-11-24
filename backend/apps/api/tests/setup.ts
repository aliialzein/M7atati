// Test-only keys; production configuration never falls back to these values.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET =
  'bd99a749a53c3a761dbf4d7a2682ce2463d671621f588859263efab83ad806a8';
process.env.JWT_REFRESH_SECRET =
  'c11ba37599aeadbf6bcb8062e256956d3c95096979c749c2bbe053b58e1ae232';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:4000';
process.env.JWT_ISSUER = 'm7atati-api';
process.env.JWT_AUDIENCE = 'm7atati-web';
