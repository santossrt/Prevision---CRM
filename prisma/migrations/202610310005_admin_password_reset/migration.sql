-- Administrative resets are explicit grants. Public recovery continues to
-- require an active account with a password and cannot issue this purpose.
ALTER TYPE "public"."AccessTokenPurpose" ADD VALUE 'ADMIN_PASSWORD_RESET';
