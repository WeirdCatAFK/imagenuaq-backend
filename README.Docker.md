### Building and running your application

When you're ready, start your application by running:
`docker compose up --build`.

Your application will be available at http://localhost:3000.

The port is not hardcoded: Compose reads `PORT` from the `.env` file in this
directory (falling back to `3000`) and uses it for both the published port and
the `PORT` variable the app reads. Set `PORT=8080` in `.env` — or run
`PORT=8080 docker compose up --build` — and the app is served on that port
instead. `HOST` is forced to `0.0.0.0` in the container so the published port
reaches it; the app's own `localhost` default would only bind loopback.

### Deploying your application to the cloud

First, build your image, e.g.: `docker build -t myapp .`.
If your cloud uses a different CPU architecture than your development
machine (e.g., you are on a Mac M1 and your cloud provider is amd64),
you'll want to build the image for that platform, e.g.:
`docker build --platform=linux/amd64 -t myapp .`.

Then, push it to your registry, e.g. `docker push myregistry.com/myapp`.

Consult Docker's [getting started](https://docs.docker.com/go/get-started-sharing/)
docs for more detail on building and pushing.

### References
* [Docker's Node.js guide](https://docs.docker.com/language/nodejs/)