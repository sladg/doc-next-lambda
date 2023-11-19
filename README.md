# Deploying Next to Lambda
Summary of knowledge in regards to deploying NextJS to Amazon Lambdas.

_TL;DR: NextJS in standalone mode + [lwa layer](https://github.com/awslabs/aws-lambda-web-adapter) = deployment on Function URL._

## Problems

### Network adapter

NextJS expects normal HTTP request and response objects whilst AWS Lambda together with other AWS services provide event object. This incompatibility results in problematic translation of incoming data and results.

Resources and solutions:
- https://www.npmjs.com/package/serverless-http
- https://github.com/aws-samples/lwa-nextjs-response-streaming-example
- https://github.com/awslabs/aws-lambda-web-adapter
- build custom HTTP server which translates some methods to compatible ones

- [ ] TBD describe solution

### Cold starts
Next server takes quite a bit of time to fire-up at the beggining. Vercel is working 

- [ ] TBD describe solution, 

### Caching
Next uses variety of caches and different mechanisms to improve performance. This results in rather over-complicated config for CloudFront.
Additional problem comes from Lambda's non-writable storage. Next will try to cache (write it) sometimes, this operation can fail, but results in lost performance.

- [ ] TBD describe solution, exploring EFS.

### Binaries
Lambda's runtime (if we ignore containerized option), uses Amazon Linux (multiple version options). This results in some of the binaries being possibly incompatible compared in runtime as buildtime used different OS / architecture. This is mostly notable in Prisma as their binaries take quite a lot of space.

- [ ] TBD describe solution

## Knowledge
One of the first topics on ISR in non-Vercel environment. Main outcome is Vercel providing guide with basics.
https://github.com/vercel/next.js/discussions/19589

Vercel's guide to self-hosting. Most limited to non-serverless and containerised applications. Useful information about `isrMemoryCacheSize`.
https://nextjs.org/docs/app/building-your-application/deploying#docker-image

SAM template allowing Next on Lambda with streaming support. Primary infromation is env variable `AWS_LWA_INVOKE_MODE: response_stream` and `InvokeMode: RESPONSE_STREAM`.
https://github.com/aws-samples/lwa-nextjs-response-streaming-example/blob/main/template.yaml

Minimal example in Express showing how to use LWA outside of container, aka. in native runtime. This is implementable for NextJS.
https://github.com/awslabs/aws-lambda-web-adapter/tree/main/examples/expressjs-zip

OG pioneer of runing HTTP servers on Lambda.
https://github.com/apparentorder/reweb

## Testing and benchmarks

Next 13.5 takes 800-900ms to initialise in Lambda native Node environment (very similar result for Alpine container on Lambda). This happens once-per-instance, meaning, this instance can deal with multiple requests without re-starting. Increased load on application will result in spin-up of multiple new instances, each taking this time to start.

<img width="712" alt="image" src="https://github.com/sladg/doc-next-lambda/assets/26263265/cc2d494e-8bad-4679-a500-5690e411f454">

