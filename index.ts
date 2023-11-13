import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { registerAutoTags } from "./autotag";


let awsConfig = new pulumi.Config("aws");
let region = awsConfig.require("region");
let defaultTags = awsConfig.require("defaultTags");

let tags = JSON.parse(defaultTags)["tags"]
console.log(tags)

// auto tag solution
// see also: https://github.com/joeduffy/aws-tags-example/tree/master/autotag-ts
registerAutoTags({
    "user:Project": pulumi.getProject(),
    "user:Stack": pulumi.getStack(),
    ...tags
});


// TODO
// endpoint service: vpc.addS3GatewayEndpoint()
// subnetType as property
// create vpc with 6 subnets, 3 for public and 3 for private 
const vpc = new awsx.ec2.Vpc("airTekVpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    instanceTenancy: "default",
    natGateways: {
        strategy: "None",
    }, // instead using nat gateway to get image from ECR, use VPC Endpoint to save NAT gateway cost and data transfer cost
});

// gateway endpoint
const vpcS3Endpoint = new aws.ec2.VpcEndpoint("vpcS3Endpoint", {
    serviceName: `com.amazonaws.${region}.s3`,
    vpcId: vpc.vpcId,
    routeTableIds: [
        vpc.routeTables.apply(rt => rt[0].id),
        vpc.routeTables.apply(rt => rt[1].id),
        vpc.routeTables.apply(rt => rt[2].id),
        vpc.routeTables.apply(rt => rt[3].id),
        vpc.routeTables.apply(rt => rt[4].id),
        vpc.routeTables.apply(rt => rt[5].id),
    ],
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Sid: "Access-to-specific-AWS-ECR-bucket-only",
            Effect: "Allow",
            Principal: {
                AWS: "*",
            },
            Action: ["s3:GetObject"],
            Resource: `arn:aws:s3:::prod-${region}-starport-layer-bucket/*`,
        }],
    }),
});

// for pull image from ecr
const vpcEcrEndpointSg = new aws.ec2.SecurityGroup("vpcEcrEndpointSg", {
    description: "vpcEcrEndpointSg",
    vpcId: vpc.vpcId,
    ingress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: [
                "10.0.0.0/16"
            ],
        }
    ],
    egress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: ["0.0.0.0/0"]
        }
    ]
});

const vpcEcrEndpoint = new aws.ec2.VpcEndpoint("vpcEcrEndpoint", {
    serviceName: `com.amazonaws.${region}.ecr.dkr`,
    vpcId: vpc.vpcId,
    vpcEndpointType: "Interface",
    securityGroupIds: [
        vpcEcrEndpointSg.id
    ],
    subnetIds: vpc.privateSubnetIds,
    privateDnsEnabled: true
});

const vpcEcrApiEndpointSg = new aws.ec2.SecurityGroup("vpcEcrApiEndpointSg", {
    description: "vpcEcrApiEndpointSg",
    vpcId: vpc.vpcId,
    ingress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: [
                "10.0.0.0/16"
            ],
        }
    ],
    egress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: ["0.0.0.0/0"]
        }
    ]
});

const vpcEcrApiEndpoint = new aws.ec2.VpcEndpoint("vpcEcrApiEndpoint", {
    serviceName: `com.amazonaws.${region}.ecr.api`,
    vpcId: vpc.vpcId,
    vpcEndpointType: "Interface",
    securityGroupIds: [
        vpcEcrApiEndpointSg.id
    ],
    subnetIds: vpc.privateSubnetIds,
    privateDnsEnabled: true
});

// for ecs to cloudwatch log
const vpcCloudWatchEndpointSg = new aws.ec2.SecurityGroup("vpcCloudWatchEndpointSg", {
    description: "vpcCloudWatchEndpointSg",
    vpcId: vpc.vpcId,
    ingress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: [
                "10.0.0.0/16"
            ],
        }
    ],
    egress: [
        {
            fromPort: 0,
            toPort: 0,
            protocol: "all",
            cidrBlocks: ["0.0.0.0/0"]
        }
    ]
});



const vpcCloudWatchEndpoint = new aws.ec2.VpcEndpoint("vpcCloudWatchEndpoint", {
    serviceName: `com.amazonaws.${region}.logs`,
    vpcId: vpc.vpcId,
    vpcEndpointType: "Interface",
    securityGroupIds: [
        vpcEcrEndpointSg.id
    ],
    subnetIds: vpc.privateSubnetIds,
    privateDnsEnabled: true
});

// TODO
// lb.addListener()
// create public load balancer
const publicLbSg = new aws.ec2.SecurityGroup("publicLbSg", {
    description: "publicLbSg",
    vpcId: vpc.vpcId,
});

new aws.ec2.SecurityGroupRule("allowPublicLbSgOut", {
    fromPort: 0,
    toPort: 0,
    securityGroupId: publicLbSg.id,
    protocol: "all",
    type: "egress",
    cidrBlocks: ["0.0.0.0/0"]
});

new aws.ec2.SecurityGroupRule("allowWorldAccessPort80", {
    fromPort: 80,
    toPort: 80,
    securityGroupId: publicLbSg.id,
    protocol: "TCP",
    type: "ingress",
    cidrBlocks: ["0.0.0.0/0"]
})



const publicLB = new aws.alb.LoadBalancer("publicLB", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [
        publicLbSg.id
    ],
    subnets: vpc.publicSubnetIds,
});


// create 2 target group and 2 listener for blue/green deployment
const FrontendTargetGroupA = new aws.alb.TargetGroup("FrontendTargetGroupA", {
    port: 5000, // match container port
    targetType: "ip",
    vpcId: vpc.vpcId,
    protocol: "HTTP"
});

const httpListener80 = new aws.alb.Listener("httpListener80", {
    port: 80,
    defaultActions: [
        {
            type: "forward",
            targetGroupArn: FrontendTargetGroupA.arn
        }
    ],
    loadBalancerArn: publicLB.arn,
});

// create private load balancer
const privateLbSg = new aws.ec2.SecurityGroup("privateLbSg", {
    description: "privateLbSg",
    vpcId: vpc.vpcId,
});

new aws.ec2.SecurityGroupRule("allowPrivateLbSgOut", {
    fromPort: 0,
    toPort: 0,
    securityGroupId: privateLbSg.id,
    protocol: "all",
    type: "egress",
    cidrBlocks: ["0.0.0.0/0"]
})

const privateLB = new aws.alb.LoadBalancer("privateLB", {
    internal: true,
    loadBalancerType: "application",
    securityGroups: [
        privateLbSg.id
    ],
    subnets: vpc.privateSubnetIds,
});


// create 2 target group and 2 listener for blue/green deployment
const BackendTargetGroupA = new aws.alb.TargetGroup("BackendTargetGroupA", {
    port: 5000, // match container port
    targetType: "ip",
    vpcId: vpc.vpcId,
    protocol: "HTTP",
    healthCheck: {
        path: "/WeatherForecast"
    }
});

const internalApiListener5000 = new aws.alb.Listener("internalApiListener5000", {
    port: 80,
    defaultActions: [
        {
            type: "forward",
            targetGroupArn: BackendTargetGroupA.arn
        }
    ],
    loadBalancerArn: privateLB.arn,
});

// create backendServiceSg
const backendServiceSg = new aws.ec2.SecurityGroup("backendServiceSg", {
    description: "backendServiceSg",
    vpcId: vpc.vpcId,
});
new aws.ec2.SecurityGroupRule("allowBackendServiceOut", {
    fromPort: 0,
    toPort: 0,
    securityGroupId: backendServiceSg.id,
    protocol: "all",
    type: "egress",
    cidrBlocks: ["0.0.0.0/0"]
})

new aws.ec2.SecurityGroupRule("allowPrivateAlbAccess", {
    fromPort: 5000,
    toPort: 5000,
    securityGroupId: backendServiceSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: privateLbSg.id
})

new aws.ec2.SecurityGroupRule("allowBackendServiceAccessEcrEndpoint", {
    fromPort: 443,
    toPort: 443,
    securityGroupId: vpcEcrEndpointSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: backendServiceSg.id
})

new aws.ec2.SecurityGroupRule("allowBackendServiceAccessCwEndpoint", {
    fromPort: 443,
    toPort: 443,
    securityGroupId: vpcCloudWatchEndpointSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: backendServiceSg.id
})

const backendServiceLogGroup = new aws.cloudwatch.LogGroup("backendServiceLogGroup", {})

const backendServiceExecutionRole = new aws.iam.Role("backendServiceExecutionRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                "Action": "sts:AssumeRole",
                "Effect": "Allow",
                "Principal": {
                    "Service": "ecs-tasks.amazonaws.com"
                }
            }
        ]
    }),
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
    ]
})

// service
const frontendRepository = new awsx.ecr.Repository("frontendRepository", { forceDelete: true });
const frontendImage = new awsx.ecr.Image("frontendImage", {
    repositoryUrl: frontendRepository.url,
    path: "service/", // relative to pulumi project root
    dockerfile: "service/infra-web/Dockerfile",
    // extraOptions:[
    //     "--platform=linux/amd64"
    // ]
})


const backendRepository = new awsx.ecr.Repository("backendRepository", { forceDelete: true });
const backendImage = new awsx.ecr.Image("backendImage", {
    repositoryUrl: frontendRepository.url,
    path: "service/", // relative to pulumi project root
    dockerfile: "service/infra-api/Dockerfile",
    // extraOptions:[
    //     "--platform=linux/amd64"
    // ]
})


const cluster = new aws.ecs.Cluster("cluster", {
    name: "ari-tek-cluster",
})

const backendService = new awsx.ecs.FargateService("backendService", {
    cluster: cluster.arn,
    propagateTags: "SERVICE",
    taskDefinitionArgs: {
        container: {
            image: backendImage.imageUri,
            cpu: 512,
            memory: 512,
            portMappings: [
                {
                    targetGroup: BackendTargetGroupA,
                    containerPort: 5000,
                }
            ],
            name: "backendService",
        },
        executionRole: {
            roleArn: backendServiceExecutionRole.arn
        },
        logGroup: {
            existing: {
                arn: backendServiceLogGroup.arn
            }
        },
    },
    networkConfiguration: {
        subnets: vpc.publicSubnetIds,
        securityGroups: [
            backendServiceSg.id
        ],
    },

    // deploymentController: {
    //     type: "CODE_DEPLOY"
    // },
    platformVersion: "1.4.0", // if use latest(1.4.0) required com.amazonaws.region.ecr.api vpc endpoint

}
)




// create frontendServiceSg
const frontendServiceSg = new aws.ec2.SecurityGroup("frontendServiceSg", {
    description: "frontendServiceSg",
    vpcId: vpc.vpcId,
});
new aws.ec2.SecurityGroupRule("allowFrontendServiceOut", {
    fromPort: 0,
    toPort: 0,
    securityGroupId: frontendServiceSg.id,
    protocol: "all",
    type: "egress",
    cidrBlocks: ["0.0.0.0/0"]
})

new aws.ec2.SecurityGroupRule("allowPublicAlbAccess", {
    fromPort: 5000,
    toPort: 5000,
    securityGroupId: frontendServiceSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: publicLbSg.id
})
new aws.ec2.SecurityGroupRule("allowFrontendServiceAccessPrivateAlb", {
    fromPort: 80,
    toPort: 80,
    securityGroupId: privateLbSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: frontendServiceSg.id
})

new aws.ec2.SecurityGroupRule("allowFrontendServiceAccessEcrEndpoint", {
    fromPort: 443,
    toPort: 443,
    securityGroupId: vpcEcrEndpointSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: frontendServiceSg.id
})

new aws.ec2.SecurityGroupRule("allowFrontendServiceAccessCwEndpoint", {
    fromPort: 443,
    toPort: 443,
    securityGroupId: vpcCloudWatchEndpointSg.id,
    protocol: "TCP",
    type: "ingress",
    sourceSecurityGroupId: frontendServiceSg.id
})


const frontendServiceLogGroup = new aws.cloudwatch.LogGroup("frontendServiceLogGroup", {})

const frontendServiceExecutionRole = new aws.iam.Role("frontendServiceExecutionRole", {
    assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                "Action": "sts:AssumeRole",
                "Effect": "Allow",
                "Principal": {
                    "Service": "ecs-tasks.amazonaws.com"
                }
            }
        ]
    }),
    managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
    ]
})


const frontendService = new awsx.ecs.FargateService("frontendService", {
    cluster: cluster.arn,
    propagateTags: "SERVICE",
    taskDefinitionArgs: {
        container: {
            image: frontendImage.imageUri,
            cpu: 512,
            memory: 512,
            portMappings: [
                {
                    targetGroup: FrontendTargetGroupA,
                    containerPort: 5000,
                }
            ],
            name: "frontendService",
            environment: [
                {
                    name: "ApiAddress",
                    value: privateLB.dnsName.apply(dnsName => `http://${dnsName}/WeatherForecast`)
                }
            ]
        },
        executionRole: {
            roleArn: frontendServiceExecutionRole.arn
        },
        logGroup: {
            existing: {
                arn: frontendServiceLogGroup.arn
            }
        },

    },
    networkConfiguration: {
        subnets: vpc.privateSubnetIds,
        securityGroups: [
            frontendServiceSg.id
        ],
    },

    // deploymentController: {
    //     type: "CODE_DEPLOY"
    // },
    platformVersion: "1.4.0", // if use latest(1.4.0) required com.amazonaws.region.ecr.api vpc endpoint or NAT gateway

},
    {
        dependsOn: backendService
    }
);

// TODO
// service.addAutoScaling()
// scaling for services
const ecsTarget = new aws.appautoscaling.Target("ecsTargetBackend", {
    maxCapacity: 4,
    minCapacity: 1,
    resourceId: pulumi.all([cluster.name, backendService.service.name]).apply(([clusterName, backendServiceName]) => `service/${clusterName}/${backendServiceName}`),
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});
const ecsPolicy = new aws.appautoscaling.Policy("ecsPolicyBackend", {
    policyType: "TargetTrackingScaling",
    resourceId: ecsTarget.resourceId,
    scalableDimension: ecsTarget.scalableDimension,
    serviceNamespace: ecsTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
        },
        targetValue: 70
    }
});
const ecsTargetFrontend = new aws.appautoscaling.Target("ecsTargetFrontend", {
    maxCapacity: 4,
    minCapacity: 1,
    resourceId: pulumi.all([cluster.name, frontendService.service.name]).apply(([clusterName, frontendServiceName]) => `service/${clusterName}/${frontendServiceName}`),
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
});
const ecsPolicyFrontend = new aws.appautoscaling.Policy("ecsPolicyFrontend", {
    policyType: "TargetTrackingScaling",
    resourceId: ecsTargetFrontend.resourceId,
    scalableDimension: ecsTargetFrontend.scalableDimension,
    serviceNamespace: ecsTargetFrontend.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
            predefinedMetricType: "ECSServiceAverageCPUUtilization",
        },
        targetValue: 70
    },
});



export const publicEndpoint = publicLB.dnsName.apply(dnsName => `http://${dnsName}`)

