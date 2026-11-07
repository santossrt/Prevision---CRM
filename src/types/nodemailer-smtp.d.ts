// SMTP uses a patched Nodemailer independently of Auth.js's unused optional
// e-mail provider peer dependency. The sendMail/SMTP surface remains typed.
declare module "nodemailer-smtp" {
  import nodemailer = require("nodemailer");
  export = nodemailer;
}
