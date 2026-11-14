# Price Scanner

Customers scan a barcode with a phone camera and see the price.
Admins upload an Excel file and every customer sees the new prices straight away.

Files
- public/index.html            the page
- netlify/functions/api.mjs    entry point for Netlify (data kept in Netlify Blobs)
- lib/core.mjs                 the price list service itself (handles 100,000+ products)
- netlify.toml, package.json   Netlify settings
- server.js                    optional: the same service for your own computer or a Node host

## A. Put it on Netlify

1. Create a free account at github.com and a new repository (public or private).
   Upload everything in this folder to it, keeping the same folders.
2. Create a free account at netlify.com. Choose Add new site, Import an existing project, GitHub,
   and pick the repository. Keep the default settings and press Deploy.
3. Open Site configuration, Environment variables, Add a variable:
   key ADMIN_PASSWORD, value = your password (use a long one).
   Then Deploys, Trigger deploy, Deploy site, so the new variable is used.
4. Open your address (https://something.netlify.app) on your phone.
   Scroll to Admin, sign in, upload your Excel file, press Apply.

## B. Try it on your own computer first (optional)

1. Install Node from nodejs.org (the LTS version).
2. In this folder run:

       ADMIN_PASSWORD=choose-a-password node server.js

   Windows PowerShell:

       $env:ADMIN_PASSWORD="choose-a-password"; node server.js

3. Open http://localhost:3000 in your browser. The camera works on localhost.
   To open it on your phone, use Netlify (the phone camera needs https).

## Large lists

The list is split into 256 small pieces, so a lookup reads one small piece and stays fast even with
100,000+ products. Uploads are sent in batches of 10,000 rows with a progress counter.
Keep the page open until it says Done. If an upload is interrupted, the old list is still in use.
On a phone, uploading 100,000 rows can be slow: upload from a computer.

## Excel file

One sheet, columns `barcode`, `name`, `price`, headers in row 1.
Format the barcode column as Text. In Admin, "Download template" gives a ready file.
