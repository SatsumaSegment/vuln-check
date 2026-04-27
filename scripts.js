const ghUrlInput = document.getElementById("github-url-input");
const fileInput = document.getElementById("file-input");
const container = document.getElementById('response-content');
const submit = document.getElementById("submit");

const osvUrl = "https://api.osv.dev/v1/query";


submit.addEventListener('click', async () => {

    try {

        container.innerHTML = `<div class="spinner"></div>`;
        submit.disabled = true;

        ghUrl = ghUrlInput.value.toLowerCase();
        if (ghUrl && !ghUrl.startsWith("https://github.com/")) {
            console.log("error: Invalid GitHub URL");
            return;
        }

        let deps = [];

        if (fileInput.files) {
            const run = async () => {
                try {
                    const files = Array.from(fileInput.files);
                    for (const f of files) {
                        const content = await f.text();
                        gatherDeps(deps, {path: f.name}, content);
                    }
                } catch (err) {
                    console.error(err);
                }
            }
            await run();
        }

        if (ghUrl) {
            const projectDeps = await searchGitFiles(ghUrl);
            deps.push(...projectDeps);
        }
        const osvPayload = formatForOSV(deps);
        const osvResponse = await fetch("https://api.osv.dev/v1/querybatch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(osvPayload)
        });
        const vulnerabilities = await osvResponse.json();
        const allVulnIds = vulnerabilities.results
            .flatMap(result => result.vulns || [])
            .map(v => v.id)
        const uniqueVulnIds = [...new Set(allVulnIds)];

        if (uniqueVulnIds.length > 0) {
            const fullVulnerabilities = await fetchVulnerabilityDetails(uniqueVulnIds);
            displayVulnerabilities(fullVulnerabilities);
        } else if (uniqueVulnIds.length === 0) {
            displayVulnerabilities([]);
            return;
        }
    } catch (err) {
        container.innerHTML = `<p>Error: ${err.message}</p>`;
    } finally {
        submit.disabled = false;
    }
    
})


async function searchGitFiles(githubUrl) {
    // Convert repo URL to API URL
    const apiUrl = githubUrl.replace("github.com", "api.github.com/repos");
    
    try {
        // Find default branch
        const repoInfo = await fetch(apiUrl);
        if (!repoInfo.ok) throw new Error("Repo not found or Rate Limited");
        const repoData = await repoInfo.json();
        const defaultBranch = repoData.default_branch;
        const [owner, repoName] = repoData.full_name.split('/');

        // Get project tree
        const treeResponse = await fetch(`${apiUrl}/git/trees/${defaultBranch}?recursive=1`);
        const data = await treeResponse.json();

        // Filter dep files
        const matches = data.tree.filter(file => 
            file.path.endsWith("package.json") || file.path.endsWith("requirements.txt")
        );

        // Gather a list of all deps
        let all_deps = [];
        for (const file of matches) {
            // Use raw. URL to get files' contents
            const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/${defaultBranch}/${file.path}`;
            
            const response = await fetch(rawUrl);
            const content = await response.text();

            gatherDeps(all_deps, file, content);

        }

        return all_deps;
    } catch (err) {
        throw err
    }
}


function gatherDeps(deps, file, content) {
    try {
        if (file.path.endsWith('package.json')) {
            const pkg = JSON.parse(content);
            deps.push({
            [file.path]: {
                    dependencies: { 
                        ...(pkg.dependencies || {}), 
                        ...(pkg.devDependencies || {}) 
                    }
                }
            });
        } else if (file.path.endsWith('requirements.txt')) {
            const lines = content.split('\n');
            const pythonDeps = {};

            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const [name, version] = trimmed.split('==');
                    if (name) {
                        pythonDeps[name.trim()] = version ? version.trim() : "latest";
                    }
                }
            });

            deps.push({
                [file.path]: pythonDeps
            });
        }
    } catch (err) {
        throw err;
    }
}


function formatForOSV(allDeps) {
    // Form batch of queries for OSV request
    const queries = [];
    allDeps.forEach(fileEntry => {
        const filePath = Object.keys(fileEntry)[0];
        const deps = fileEntry[filePath];
        const ecosystem = filePath.endsWith('package.json') ? 'npm' : 'PyPI';
        const packageList = filePath.endsWith('package.json') ? deps.dependencies : deps;
        for (const [name, version] of Object.entries(packageList)) {
            const cleanVersion = version.replace(/[\^~><=]/g, '').trim();
            queries.push({
                version: cleanVersion,
                package: {
                    name: name.trim(),
                    ecosystem: ecosystem
                }
            });
        }
    });

    return { queries };
}


async function fetchVulnerabilityDetails(ids) {
    // Use vuln ids to get full details
    try {
        const detailPromises = ids.map(id => 
            fetch(`https://api.osv.dev/v1/vulns/${id}`, {signal: AbortSignal.timeout(8000)}).then(res => res.json())
        );
        const details = await Promise.allSettled(detailPromises);
        return details;
    } catch (err) {
        throw err;
    }
}


function displayVulnerabilities(vulnerabilities) {
    if (!vulnerabilities || vulnerabilities.length === 0) {
        container.innerHTML = `<div class="no-vulns">No vulnerabilities found! Your project's packages look safe.</div>`;
        return;
    }

    const html = vulnerabilities.map(vuln => {
        const severity = vuln.database_specific?.severity || 'UNKNOWN';
        const date = new Date(vuln.modified).toLocaleDateString();
        
        return `
            <div class="vuln-card ${severity.toLowerCase()}">
                <div class="vuln-header">
                    <span class="vuln-id">${vuln.id}</span>
                    <span class="vuln-severity">${severity}</span>
                </div>
                <h3 class="vuln-summary">${vuln.summary || 'No summary available'}</h3>
                <p class="vuln-details">${vuln.details.substring(0, 200)}${vuln.details.length > 200 ? '...' : ''}</p>
                
                <div class="vuln-footer">
                    <span class="vuln-date">Last Modified: ${date}</span>
                    <a href="https://osv.dev/vulnerability/${vuln.id}" target="_blank" class="view-link">View Full Report</a>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `<h2>Found ${vulnerabilities.length} Vulnerabilities</h2>` + html;
}