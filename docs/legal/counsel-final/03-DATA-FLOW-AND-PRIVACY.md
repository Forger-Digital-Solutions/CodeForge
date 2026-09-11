# Data Flow and Privacy

| Data | Destination | Purpose | Current technical fact | Open question |
| --- | --- | --- | --- | --- |
| Project files/context | Local process; selected provider during inference | Coding task execution | Host filesystem access is required | Required notice, retention, and controller posture |
| BYOK credential | Local Electron user data | Authenticate provider calls | `safeStorage` encrypted payload; raw key is not exposed to renderer | Recovery/deletion wording |
| Prompt/output | User-selected provider | Inference | Provider adapter performs network call | Provider retention/training and regional terms |
| Recent projects/settings | Local user data | Reopen projects and preferences | Atomic JSON settings file | Retention/deletion language |
| Cloud auth token | Cloud feature path | Account/cloud access | Must remain distinct from provider credentials | Exact privacy notice and retention |
| GitHub OAuth | Transient/server auth path | GitHub operations | Desktop should not persist OAuth access token | Counsel confirmation of disclosure |

No analytics, marketing, or paid-inference claim is added by this milestone.
The package-specific network and dependency evidence remains pending exact
Windows packaging.
